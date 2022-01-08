#!/usr/bin/env node

require('dotenv').config()

const H = require('highland')
const turf = require('@turf/turf')

const hexSize = parseFloat(process.env.HEX_SIZE)
const bbox = process.env.BBOX
  .split(',')
  .map((str) => parseFloat(str))

const options = {
  units: 'meters'
}

const hexgrid = turf.hexGrid(bbox, hexSize, options)

H(hexgrid.features)
  .map(({ geometry }) => ({
    geometry
  }))
  .map(JSON.stringify)
  .intersperse('\n')
  .pipe(process.stdout)
