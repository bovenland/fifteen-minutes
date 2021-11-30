#!/usr/bin/env node

require('dotenv').config()

const argv = require('yargs')
  .options({
    'intersects': {
      alias: 'i',
      describe: 'GeoJSON polygon all road segments should intersect with'
    }
  })
  .help('help')
  .argv

const fs = require('fs')
const axios = require('axios')
const H = require('highland')
const turf = require('@turf/turf')
const pg = require('pg')
const QueryStream = require('pg-query-stream')

const osrmPort = 7000

const pool = new pg.Pool()

const speed = process.env.SPEED
const minutes = process.env.MINUTES

const gridResolution = process.env.GRID_RESOLUTION

const postcodeLength = parseInt(process.env.POSTCODE_LENGTH)

const distance = minutes / 60 * speed * 1000

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundDecimals (num, decimals = 5) {
  const f = Math.pow(10, 6)
  return Math.round((num + Number.EPSILON) * f) / f
}

function createOriginsQuery (polygon, length = 6) {
  let postcodeColumn
  if (length === 6) {
    postcodeColumn = `tags->'addr:postcode'`
  } else if (length === 4 || length === 5) {
    postcodeColumn = `substring((tags->'addr:postcode') from 1 for ${length})`
  } else {
    throw new Error('Invalid postcode length')
  }

  return `SELECT
    postcode,
    ST_AsGeoJSON(ST_Transform((
      SELECT way AS nearest_address
      FROM planet_osm_point
      WHERE ${postcodeColumn} = postcode
      ORDER BY way <-> centroid
      LIMIT 1
    ), 4326))::json AS origin
  FROM
  (
    WITH postcodes AS (
      SELECT DISTINCT ${postcodeColumn} AS postcode
      FROM planet_osm_point
      WHERE ${postcodeColumn} <> ''
    )
    SELECT
      ${postcodeColumn} AS postcode,
      ST_Centroid(ST_Collect(way)) AS centroid
    FROM planet_osm_point p1, postcodes
    WHERE
      ${postcodeColumn} = postcodes.postcode AND
      ${polygon ? `ST_Intersects(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(polygon)}'), 4326), 3857), way)` : 'TRUE'}
    GROUP BY ${postcodeColumn}
  ) centroids`
}

async function fetch (url) {
  try {
    const response = await axios.get(url)
    return response.data
  } catch (err) {
    console.error(url, err.message)
  }
}

async function computeGrid ({ origin, postcode }, distance, gridResolution, postcodeLength) {
  console.error('Computing grid:', postcode)
  if (postcode.length !== postcodeLength) {
    return
  }

  // Add gridResolution * 2 to make sure grid contains all hexagons of which
  // the centroid _might_ be in range
  const distanceAroundOrigin = turf.buffer(origin, distance + gridResolution * 2, { units: 'meters' })

  const hexGrid = turf.hexGrid(turf.bbox(distanceAroundOrigin), gridResolution, {
    units: 'meters',
    mask: distanceAroundOrigin
  })

  const hexagons = hexGrid.features
  const centroids = hexagons.map((hexagon) => turf.centroid(hexagon))

  const destinations = centroids
    .map((feature) => feature.geometry.coordinates.map(roundDecimals))

  const osrmTableUrl = `http://localhost:${osrmPort}/table/v1/walking/${origin.coordinates.join(',')};${destinations.map((coordinate) => coordinate.join(',')).join(';')}?sources=0`

  const osrmTableResult = await fetch(osrmTableUrl)

  const routeDestinations = osrmTableResult.destinations
    .map((destination, index) => ({
      duration: Math.round(osrmTableResult.durations[0][index]),
      geometry: {
        type: 'Point',
        coordinates: destination.location
      }
    }))
    .filter((destination, index) => {
      if (index >= 1) {
        const gridDestination = destinations[index - 1]
        const difference = turf.distance(destination.geometry, turf.point(gridDestination), { units: 'meters' })

        return difference <= gridResolution
      }
    })
    .filter(({ duration }) => duration <= minutes * 60)
    .sort((a, b) => b.duration - a.duration)

  await sleep(100)

  return {
    postcode,
    origin,
    durations: routeDestinations.map(({ duration }) => duration),
    geometry: {
      type: 'MultiPoint',
      coordinates: routeDestinations
        .map(({ geometry }) => geometry.coordinates)
    }
  }
}

async function run (polygon) {
  const query = createOriginsQuery(polygon, postcodeLength)

  const client = await pool.connect()
  const stream = client.query(new QueryStream(query))

  const data = H(stream)
    .flatMap((row) => H(computeGrid(row, distance, gridResolution, postcodeLength)))
    .compact()
    .map(JSON.stringify)
    .intersperse('\n')

  data
    .pipe(process.stdout)

  data.observe()
    .done(() => client.release())
}

let polygon
if (argv.intersects) {
  const filename = argv.intersects
  polygon = JSON.parse(fs.readFileSync(filename))
}

run(polygon)
