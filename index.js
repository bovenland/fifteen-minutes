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
const H = require('highland')
const turf = require('@turf/turf')
const pg = require('pg')
const simpleStatistics = require('simple-statistics')
const QueryStream = require('pg-query-stream')

const pool = new pg.Pool()

const speed = process.env.SPEED
const radials = process.env.RADIALS
const minutes = process.env.MINUTES
const chunkLength = process.env.CHUNK_LENGTH
const minLineLength = process.env.MIN_LINE_LENGTH
const destinationThreshold = process.env.DESTINATION_THRESHOLD

const distance = minutes / 60 * speed

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundDecimals (num, decimals = 5) {
  const f = Math.pow(10, 6)
  return Math.round((num + Number.EPSILON) * f) / f
}

function makeOsrmUrl (origin, destination) {
  return `http://localhost:6000/route/v1/walking/${origin.coordinates.join(',')};${destination.coordinates.join(',')}?overview=full&geometries=geojson&annotations=nodes`
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

// TODO: create hex grid where each hex overlaps with highway,
// then use middle of hex grid
// https://wiki.openstreetmap.org/wiki/Key:highway
// TODO: upgrade to PostGIS 3.1
// const query = `
// SELECT hexes.geom
// FROM
//     ST_HexagonGrid(
//         10,
//         ST_SetSRID(SELECT ST_EstimatedExtent('osm_linestring', 'geometry'), 3857)
//     ) AS hexes
// `

const createOriginsQuery = (polygon) => `
  SELECT
    postcode,
    ST_AsGeoJSON(ST_Transform((
      SELECT way AS nearest_address
      FROM planet_osm_point
      WHERE tags->'addr:postcode' = postcode
      ORDER BY way <-> centroid
      LIMIT 1
    ), 4326))::json AS origin
  FROM
  (
    WITH postcodes AS (
      SELECT DISTINCT tags->'addr:postcode' AS postcode
      FROM planet_osm_point
      WHERE tags->'addr:postcode' <> ''
    )
    SELECT
      tags->'addr:postcode' AS postcode,
      ST_Centroid(ST_Collect(way)) AS centroid
    FROM planet_osm_point p1, postcodes
    WHERE
      tags->'addr:postcode' = postcodes.postcode AND
      ${polygon ? `ST_Intersects(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(polygon)}'), 4326), 3857), way)` : 'TRUE'}
    GROUP BY tags->'addr:postcode'
  ) centroids
`

// const createOriginsQuery = (polygon) => `
//   SELECT
//     osm_id, highway,
//     ST_asGeoJSON(ST_Transform(geometry, 4326), 6)::json AS geojson
//   FROM
//     osm_linestring
//   WHERE
//     ${polygon ? `ST_Intersects(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(polygon)}'), 4326), 3857), geometry)` : 'TRUE'} AND
//     --ST_Length(geometry) > ${minLineLength} AND
//     highway <> '' AND
//     NOT highway = ANY(ARRAY['motorway', 'trunk', 'motorway_link', 'trunk_link'])`

// function lineChunks (row, chunkLength) {
//   const chunks = turf.lineChunk(row.geojson, chunkLength, { units: 'meters' })

//   return chunks.features.map((chunk) => ({
//     osmId: row.osm_id,
//     highway: row.highway,
//     geometry: chunk.geometry
//   }))
// }

async function fetch (url) {
  try {
    const response = await axios.get(url)
    return response.data
  } catch (err) {
    console.error(url, err.message)
  }
}

async function analyze ({ origin, postcode }, distance, radials) {
  console.error('Computing routes:', postcode)
  if (postcode.length !== 6) {
    return
  }

  const destinations = Array.from({ length: radials })
    .map((_, index) => destination(origin, distance, 360 / radials * index))
    .map((feature) => feature.geometry)

  const osrmUrls = destinations.map((destination) => makeOsrmUrl(origin, destination))

  const osrmResults = await Promise.all(osrmUrls.map(fetch))
  const routes = osrmResults
    .filter((result) => result)
    .map((result) => result.routes[0].geometry)

  const routesLastPoints = routes.map((route) => route.coordinates[route.coordinates.length - 1])
  const distancesToDestination = routesLastPoints
    .map((point, index) => turf.distance(destinations[index], turf.point(point), { units: 'meters' }))
    .map(roundDecimals)

  const distanceRatios = routes.map(computeDistanceRatio).map(roundDecimals)

  await sleep(100)

  return {
    query: {
      postcode
      // osmId
    },
    destinations: {
      type: 'MultiPoint',
      coordinates: destinations.map((destination) => destination.coordinates)
    },
    distancesToDestination,
    meanDistanceToDestination: simpleStatistics.mean(distancesToDestination),
    reachableMeanDistanceToDestination:

    // destinationsWithinThreshold: distancesToDestination.map((distance) => distance <= destinationThreshold),

    distanceRatios,
    meanDistanceRatio: simpleStatistics.mean(distanceRatios),

    // reachableMeanDistanceRatio
    // reachableCount:

    routes: {
      type: 'MultiLineString',
      coordinates: routes.map((route) => route.coordinates)
    },

    origin: origin.geometry
  }
}

async function run (polygon) {
  const query = createOriginsQuery(polygon)

  const client = await pool.connect()
  const stream = client.query(new QueryStream(query))

  const data = H(stream)
    // .map((row) => lineChunks(row, chunkLength))
    // .flatten()
    .flatMap((row) => H(analyze(row, distance, radials)))
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
