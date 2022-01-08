#!/usr/bin/env node

const H = require('highland')
const turf = require('@turf/turf')

function simplify (geometry) {
  if (turf.length(geometry) === 0) {
    return
  }

  const options = {
    tolerance: 0.00005,
    highQuality: true
  }

  return turf.simplify(geometry, options)
}

function chunk (lineString) {
  if (!lineString) {
    return
  }

  const options = {
    units: 'meters'
  }

  const segmentLength = 250

  const chunks = turf.lineChunk(lineString, segmentLength, options).features

  return chunks.map((chunk, index) => ({
    ...chunk,
    properties: {
      index
    }
  }))
}

H(process.stdin)
  .split()
  .compact()
  .map(JSON.parse)
  .map((row) => {
    const routes = row.geometry.coordinates
      .map((coordinates) => ({
        type: 'LineString',
        coordinates
      }))
      .map((lineString) => simplify(lineString))
      .map((lineString) => chunk(lineString))
      .filter((lineStrings) => lineStrings)
      .flat()

    const area = simplify(row.area.geometry)

    return {
      osmId: row.osmId,
      postcode: row.postcode,
      area,
      routes: {
        type: 'FeatureCollection',
        features: routes
      }
    }
  })
  .map(JSON.stringify)
  .intersperse('\n')
  .pipe(process.stdout)
