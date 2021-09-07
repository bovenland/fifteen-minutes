#!/usr/bin/env node

const H = require('highland')

const data = H(process.stdin)
  .split()
  .compact()
  .map(JSON.parse)
  .filter((line) => line.type === 'concave-hull')
  .map((hull) => {
    console.log(hull)
  })
  .done(() => {})
  // .flatMap((row) => H(computeRadialRoutes(row, distance, radials, postcodeLength)))
  // .compact()
