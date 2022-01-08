#!/usr/bin/env node

require('dotenv').config()

const fs = require('fs')
const H = require('highland')
const R = require('ramda')
const turf = require('@turf/turf')
const concaveman = require('concaveman')
const simpleStatistics = require('simple-statistics')
const kdbush = require('kdbush')
const geokdbush = require('geokdbush')

const speed = parseFloat(process.env.SPEED)
const minutes = parseFloat(process.env.MINUTES)
const gridResolution = parseFloat(process.env.GRID_RESOLUTION)
const concavity = parseFloat(process.env.CONCAVITY)
const lengthThreshold = parseFloat(process.env.LENGTH_THRESHOLD)
const segmentCount = parseFloat(process.env.SEGMENT_COUNT)

function roundDecimals (num, decimals = 6) {
  const f = Math.pow(10, 6)
  return Math.round((num + Number.EPSILON) * f) / f
}

function computeLength (geometry) {
  return turf.length(geometry, { units: 'meters' })
}

function makeStraightLine (geometry) {
  const coordinates = geometry.coordinates
  return turf.lineString([coordinates[0], coordinates[coordinates.length - 1]])
}

function computeStraightLineLength (geometry) {
  return computeLength(makeStraightLine(geometry))
}

function computeDistanceRatio (route) {
  const straightLine = makeStraightLine(route)

  const length = computeLength(route)
  const distance = computeLength(straightLine)

  return length / distance
}

function computeSegmentIndex (route) {
  const origin = turf.point(route.coordinates[0])
  const destination = turf.point(route.coordinates[route.coordinates.length - 1])

  const bearing = turf.bearing(origin, destination)
  const segmentIndex = Math.floor((bearing + 360 - (360 / segmentCount / 2)) / segmentCount) % segmentCount

  return segmentIndex
}

function analyzeRoutes (row) {
  const routes = row.geometry.coordinates
    .map((lineString) => ({
      type: 'LineString',
      coordinates: lineString
    }))

  const distances = row.distances

  const groupedBySegment = R.groupBy(computeSegmentIndex, routes)
  const maxDistancePerSegment = Object.entries(groupedBySegment)
    .map(([ segmentId, routes ]) => {
      const sortedByDistance = routes
        .map(computeStraightLineLength)
        .sort((a, b) => b - a)

      return {
        segmentId: parseInt(segmentId),
        distance: Math.round(sortedByDistance[0])
      }
    })
    .reduce((maxDistancePerSegment, segment) => {
      maxDistancePerSegment[segment.segmentId] = segment.distance
      return maxDistancePerSegment
    }, [0, 0, 0, 0, 0, 0, 0, 0])

  const lengths = routes.map(computeLength).map(Math.round)
  // const distances = routes.map(makeStraightLine).map(computerLength).map(Math.round)
  const distanceRatios = routes.map(computeDistanceRatio).map((r) => roundDecimals(r))

  const totalLength = simpleStatistics.sum(lengths)
  const weightedDistanceRatios = distanceRatios.map((distanceRatio, index) => distanceRatio * lengths[index])
  const weightedDistanceRatio = simpleStatistics.sum(weightedDistanceRatios) / totalLength

  return {
    maxDistancePerSegment,
    // lengths,
    // distances,
    // distanceRatios,
    stats: {
      distanceRatiosMean: simpleStatistics.mean(distanceRatios),
      distanceRatiosStdDev: simpleStatistics.standardDeviation(distanceRatios),
      distanceRatiosIqr: simpleStatistics.interquartileRange(distanceRatios),
      weightedDistanceRatio,

      lengthsMean: simpleStatistics.mean(lengths),
      lengthsStdDev: simpleStatistics.standardDeviation(lengths),
      distancesMean: simpleStatistics.mean(distances),
      distancesStdDev: simpleStatistics.standardDeviation(distances)
    }
  }
}

function addVertices (polygon) {
  const chunks = turf.lineChunk(turf.polygonToLine(polygon), gridResolution, { units: 'meters' })

  return turf.lineToPolygon(turf.lineString(chunks.features.reduce((lineString, chunk) => {
    return [...lineString, ...chunk.geometry.coordinates.slice(1)]
  }, [])))
}

function computeConcaveHull (polygon) {
  // Use turf.getCoords?
  const coordinates = addVertices(polygon).geometry.coordinates[0]
    .map((coordinate) => coordinate.map((num) => roundDecimals(num)))

  return {
    type: 'Polygon',
    coordinates: [
      concaveman(coordinates, concavity, lengthThreshold)
    ]
  }
}

function computeBuffer (routes) {
  const buffer = {
    type: 'FeatureCollection',
    features: routes.coordinates
      .map((route) => ({
        type: 'LineString',
        coordinates: route
      }))
      .filter((route) => route.coordinates.length > 1 && turf.length(route, { units: 'meters' }) > gridResolution)
      .map((route) => turf.simplify(route, { tolerance: 0.0001 }))
      .map((route) => turf.buffer(route, gridResolution, { units: 'meters' }))
      .map((polygon) => {
        const kinks = turf.unkinkPolygon(polygon)
        return kinks.features
      })
      .flat()
  }

  const union = buffer.features.slice(1)
    .reduce((union, buffer) => {
      try {
        return turf.union(union, removeHoles(buffer))
      } catch (err) {
        console.error('Error computing union. Skipping route...')
      }

      return union
    }, buffer.features[0])

  return union
}

function removeHoles (feature) {
  if (feature.type === 'Feature' && feature.geometry.type === 'Polygon') {
    return {
      ...feature,
      geometry: {
        type: 'Polygon',
        coordinates: feature.geometry.coordinates.slice(0, 1)
      }
    }
  } else {
    throw new Error(`Can't remove holes for ${feature.type}`)
  }
}

function analyzeArea (row) {
  const buffer = computeBuffer(row.geometry)

  if (!buffer) {
    return
  }

  const bufferWithoutHoles = removeHoles(buffer)
  const concaveHull = computeConcaveHull(bufferWithoutHoles)

  const area = turf.area(concaveHull)
  const circumference = turf.length(turf.polygonToLine(concaveHull), { units: 'meters' })

  return {
    area: Math.round(area),
    circumference: Math.round(circumference),
    areaCircumferenceRatio: roundDecimals(circumference / area),
    geometry: concaveHull
  }
}

// function analyzePois (poisIndex, area, row) {
//   const origin = row.origin
//   const maxDistance = minutes / 60 * speed

//   const filterFn = (poi) => turf.booleanPointInPolygon(poi.geometry, area.geometry)
//   const pois = geokdbush.around(poisIndex, origin.coordinates[0], origin.coordinates[1], Infinity, maxDistance, filterFn)

//   const groupedByType = R.groupBy(R.prop('type'), pois)
//   const countTypes = R.mapObjIndexed((poisOfType) => poisOfType.length, groupedByType)

//   return {
//     ...countTypes
//   }
// }

async function analyze (poisIndex, row) {
  console.error('Analyzing routes:', row.postcode)

  const area = analyzeArea(row)

  if (!area) {
    return
  }

  const analyzed = {
    ...row,
    area,
    routes: analyzeRoutes(row),
    // pois: analyzePois(poisIndex, area, row)
  }

  return analyzed
}

function readPois () {
  return new Promise((resolve, reject) => {
    H(fs.createReadStream('./data/pois.ndjson'))
      .split()
      .compact()
      .map(JSON.parse)
      .toArray((pois) => resolve(pois))
  })
}

async function run () {
  const pois = await readPois()
  const poisIndex = new kdbush(pois, (poi) => poi.geometry.coordinates[0], (poi) => poi.geometry.coordinates[1])

  H(process.stdin)
    .split()
    .compact()
    .map(JSON.parse)
    .filter((row) => {
      const routeCount = row.geometry.coordinates.length
      return routeCount > 0
    })
    .flatMap((row) => H(analyze(poisIndex, row)))
    .compact()
    .flatten()
    .map(JSON.stringify)
    .intersperse('\n')
    .pipe(process.stdout)
}

run()
