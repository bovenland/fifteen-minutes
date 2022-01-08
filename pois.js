#!/usr/bin/env node

require('dotenv').config()

const H = require('highland')

const pg = require('pg')
const QueryStream = require('pg-query-stream')
const pool = new pg.Pool()

function shops () {
  return `
    SELECT shop, ST_AsGeoJSON(ST_Transform(ST_Centroid(way), 4326))::json AS geometry
    FROM (
      SELECT
        shop, way
      FROM planet_osm_point
      UNION
      SELECT
        shop, way
      FROM planet_osm_polygon
    ) u
    WHERE
      shop = 'supermarket' OR shop = 'bakery' OR shop = 'deli'
        OR shop = 'convenience' OR shop = 'food'`
}

function schools () {
  return `
    SELECT amenity, ST_AsGeoJSON(ST_Transform(ST_Centroid(way), 4326))::json AS geometry
    FROM (
      SELECT
        amenity, way
      FROM planet_osm_point
      UNION
      SELECT
        amenity, way
      FROM planet_osm_polygon
    ) u
    WHERE
      amenity = 'school' OR amenity = 'kindergarten'
        OR amenity = 'college' OR amenity = 'university'`
}

function publicTransport () {
  return `
    SELECT highway, railway, ST_AsGeoJSON(ST_Transform(ST_Centroid(way), 4326))::json AS geometry
    FROM (
      SELECT
        highway, railway, way
      FROM planet_osm_point
      -- UNION
      -- SELECT
      --   highway, railway, way
      -- FROM planet_osm_polygon
    ) u
    WHERE
      highway = 'bus_stop' OR railway = 'station'
        OR railway = 'tram_stop'`
}

const queries = [
  shops,
  publicTransport,
  schools
]

async function run (pool) {
  const client = await pool.connect()

  const streams = queries.map((fn) => {
    const type = fn.name
    const query = fn()

    const queryStream = client.query(new QueryStream(query))

    return H(queryStream)
      .map((row) => ({
        type,
        ...row
      }))
  })

  const data = H(streams)
    .merge()
    .map(JSON.stringify)
    .intersperse('\n')

  data
    .pipe(process.stdout)

  data.observe()
    .done(() => client.release())
}

run(pool)
