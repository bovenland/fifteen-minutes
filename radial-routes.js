#!/usr/bin/env node

require('dotenv').config()

const argv = require('yargs')
  .options({
    'intersects': {
      alias: 'i',
      describe: 'GeoJSON polygon all road segments should intersect with',
    }
  })
  .help('help')
  .argv

const fs = require('fs')
const axios = require('axios')
const concaveman = require('concaveman')
const H = require('highland')
const turf = require('@turf/turf')
const pg = require('pg')
const simpleStatistics = require('simple-statistics')
const QueryStream = require('pg-query-stream')

const osrmPort = 7000

const pool = new pg.Pool()

const speed = process.env.SPEED
const radials = process.env.RADIALS
const minutes = process.env.MINUTES
const seconds = process.env.MINUTES * 60

const distance = minutes / 60 * speed

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundDecimals (num, decimals = 5) {
  const f = Math.pow(10, 6)
  return Math.round((num + Number.EPSILON) * f) / f
}

function makeOsrmRouteUrl (origin, destination) {
  return `http://localhost:${osrmPort}/route/v1/walking/${origin.coordinates.join(',')};${destination.coordinates.join(',')}?overview=full&geometries=geojson&annotations=nodes`
}

function destination (point, distance, bearing) {
  return turf.destination(point, distance, bearing - 180, {
    units: 'kilometers'
  })
}

function computeDistanceRatio (route) {
  const coordinates = route.coordinates
  const directLine = turf.lineString([coordinates[0], coordinates[coordinates.length - 1]])

  const length = turf.length(route, {units: 'kilometers'})
  const distance = turf.length(directLine, {units: 'kilometers'})

  return length / distance
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

function computeConcaveHull (pointFeatures) {
  const polygon = concaveman(pointFeatures.map((feature) => feature.geometry.coordinates))

  return turf.rewind({
    type: 'Polygon',
    coordinates: [
      [
        ...polygon,
        polygon[0]
      ]
    ]
  })
}

async function computeRadialRoutes ({ origin, postcode }, distance, radials, postcodeLength) {
  console.error('Computing routes:', postcode)
  if (postcode.length !== postcodeLength) {
    return
  }

  const radialPoints = Array.from({ length: radials })
    .map((_, index) => destination(origin, distance, 360 / radials * index))
    .map((feature) => feature.geometry)

  const mask = {
    type: 'Polygon',
    coordinates: [
      [
        ...radialPoints.map((point) => point.coordinates),
        radialPoints[0].coordinates
      ]
    ]
  }

  const grid = turf.pointGrid(turf.bbox(mask), 100, {
    units: 'meters',
    mask
  })

  const coordinates = grid.features.map((feature) => feature.geometry.coordinates.map(roundDecimals))
  const osrmTableUrl = `http://localhost:${osrmPort}/table/v1/walking/${origin.coordinates.join(',')};${coordinates.map((coordinate) => coordinate.join(',')).join(';')}?sources=0`

  const osrmTableResult = await fetch(osrmTableUrl)

  const destinations = osrmTableResult.destinations
    .map((destination, index) => ({
      type: 'Feature',
      properties: {
        duration: osrmTableResult.durations[0][index] / 3
      },
      geometry: {
        type: 'Point',
        coordinates: destination.location
      }
    }))

  const reachableDestinations = destinations
    .filter((destination, index) => {
      return destination.properties.duration <= seconds && destination.properties.duration > 0
    })

  // TODO: ALLE punten?
  const concaveHull = computeConcaveHull(reachableDestinations)

  const outerDestinations = radialPoints
    .map((point) => {
      const lineString = {
        type: 'LineString',
        coordinates: [
          origin.coordinates,
          point.coordinates
        ]
      }

      const intersections = turf.lineIntersect(concaveHull, lineString)
      if (intersections.features.length) {
        // TODO: sort by distance from origin
        return intersections.features[0].geometry
      }
    })
    .filter((destination) => destination)

  if (!outerDestinations.length) {
    console.error('No intersections with concave hull found for postcode', postcode)
  }

  const osrmRouteUrls = outerDestinations.map((destination) => makeOsrmRouteUrl(origin, destination))

  const osrmRouteResults = await Promise.all(osrmRouteUrls.map(fetch))
  const routes = osrmRouteResults
    .filter((result) => result)
    .map((result) => result.routes[0].geometry)

  const distanceRatios = routes.map(computeDistanceRatio).map(roundDecimals)

  const properties = {
    postcode,
    // distanceRatios,
    meanDistanceRatio: distanceRatios.length ? simpleStatistics.mean(distanceRatios) : null
  }

  await sleep(100)

  return [{
    ...properties,
    type: 'origin',
    geometry: origin
  }, {
    ...properties,
    area: turf.area(concaveHull),
    type: 'concave-hull',
    geometry: concaveHull
  }, {
    ...properties,
    type: 'routes',
    geometry: {
      type: 'MultiLineString',
      coordinates: routes.map((route) => route.coordinates)
    }
  }]
}

async function run (polygon) {
  const postcodeLength = 4
  const query = createOriginsQuery(polygon, postcodeLength)

  const client = await pool.connect()
  const stream = client.query(new QueryStream(query))

  const data = H(stream)
    .flatMap((row) => H(computeRadialRoutes(row, distance, radials, postcodeLength)))
    .compact()
    .flatten()
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
