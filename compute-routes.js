#!/usr/bin/env node

require('dotenv').config()

const fs = require('fs')
const axios = require('axios')
const H = require('highland')
const turf = require('@turf/turf')

const osrmPort = process.env.OSRM_PORT

const speed = process.env.SPEED
const radials = process.env.RADIALS
const minutes = process.env.MINUTES
const seconds = process.env.MINUTES * 60

const distance = minutes / 60 * speed

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundDecimals (num, decimals = 6) {
  const f = Math.pow(10, decimals)
  return Math.round((num + Number.EPSILON) * f) / f
}

function makeOsrmRouteUrl (origin, destination) {
  return `http://localhost:${osrmPort}/route/v1/walking/${origin.coordinates.join(',')};${destination.coordinates.join(',')}?overview=full&geometries=geojson&annotations=nodes`
}

async function fetch (url) {
  try {
    const response = await axios.get(url)
    return response.data
  } catch (err) {
    console.error(url, err.message)
  }
}

async function fetchRoutes (routeUrls) {
  const results = []

  for (const url of routeUrls) {
    const result = await fetch(url)
    await sleep(10)

    results.push(result)
  }

  return results
}

// function computeConcaveHull (pointFeatures) {
//   const polygon = concaveman(pointFeatures.map((feature) => feature.geometry.coordinates))

//   return turf.rewind({
//     type: 'Polygon',
//     coordinates: [
//       [
//         ...polygon,
//         polygon[0]
//       ]
//     ]
//   })
// }

async function computeRoutes ({ osmId, postcode, origin, geometry }) {
  console.error('Computing routes:', postcode)

  const destinations = geometry.coordinates
    .map((coordinates) => turf.point(coordinates).geometry)

  const routeUrls = destinations
    .map((destination) => makeOsrmRouteUrl(origin, destination))

  const osrmRouteResults = await fetchRoutes(routeUrls)

  const routes = osrmRouteResults
    .filter((result) => result)
    .map((result) => result.routes[0])
    .map((route) => {
      const nodes = route.legs[0]?.annotation?.nodes

      return {
        nodes,
        nodesStr: nodes && nodes.join('-'),
        duration: route.duration,
        distance: route.distance,
        geometry: route.geometry
      }
    })

  await sleep(100)

  const filteredRoutes = routes
    .map((route, index) => ({
      route,
      index
    }))
    .filter(({ route }) => {
      for (otherRoute of routes) {
        if (otherRoute.nodesStr.startsWith(route.nodesStr) && otherRoute.nodesStr.length > route.nodesStr.length) {
          return false
        }
      }

      return true
    })

  return {
    osmId,
    postcode,
    origin,
    distances: routes.map((route) => route.distance),
    durations: routes.map((route) => route.duration),
    filteredRouteIndexes: filteredRoutes.map(({ index }) => index),
    // nodes: routes.map((route) => route.nodes),
    geometry: {
      type: 'MultiLineString',
      coordinates: filteredRoutes.map(({ route }) => route.geometry.coordinates)
    }
  }
}

async function run () {
  H(process.stdin)
    .split()
    .compact()
    .map(JSON.parse)
    .flatMap((row) => H(computeRoutes(row)))
    .compact()
    .map(JSON.stringify)
    .intersperse('\n')
    .pipe(process.stdout)
}

run()
