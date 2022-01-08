#!/usr/bin/env node

require('dotenv').config()

const H = require('highland')
const turf = require('@turf/turf')
const pg = require('pg')

const pool = new pg.Pool()

async function findNearestAddress (client, row) {
  const hexagon = row.geometry
  const center = turf.center(row.geometry).geometry

  const query = `
    SELECT
      osm_id AS "osmId",
      "addr:housenumber" AS housenumber,
      tags->'addr:postcode' AS postcode,
      ST_AsGeoJSON(ST_Transform(way, 4326), 7)::json AS geometry
    FROM planet_osm_point
    WHERE
      "addr:housenumber" <> ''
      AND tags->'addr:postcode' <> ''
      AND ST_Intersects(ST_Transform(ST_GeomFromGeoJSON($1), 3857), way)
      -- AND ST_Distance(ST_Transform(ST_GeomFromGeoJSON($2), 3857), way) <= $3
    ORDER BY
      ST_Transform(ST_GeomFromGeoJSON($2), 3857) <-> way
    LIMIT 1`

  const { rows } = await client.query(query, [hexagon, center])

  return rows[0]
}

async function run () {
  const client = await pool.connect()

  let hexagonCount = 0
  let hexagonCountLast = 0
  let originCount = 0
  let originCountLast = 0

  H(process.stdin)
    .split()
    .compact()
    .map(JSON.parse)
    .map((hexagon) => {
      hexagonCount++
      hexagonCountLast++
      if (hexagonCount % 250 === 0) {
        console.error('Processed hexagons:', hexagonCount)
      }

      return hexagon
    })
    .flatMap((row) => H(findNearestAddress(client, row)))
    .compact()
    .map((origin) => {
      originCount++
      originCountLast++
      if (originCount % 250 === 0) {
        console.error('  Found origins:', originCount)
        console.error('    Hexagons with origins (last 250):', `${Math.round(originCountLast / hexagonCountLast  * 100)}%`)
        console.error('    Hexagons with origins (total):', `${Math.round(originCount / hexagonCount  * 100)}%`)
        originCountLast = 0
        hexagonCountLast = 0
      }

      return origin
    })
    .map(JSON.stringify)
    .intersperse('\n')
    .pipe(process.stdout)
}

run()
