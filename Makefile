routes:
	@./radial-routes.js -i flevoland-overijssel-drenthe.geojson \
		> ./data/fifteen-minutes.ndjson

reachability:
	@./reachability.js < ./data/fifteen-minutes.ndjson

geojson:
	@../ndjson-to-geojson/ndjson-to-geojson.js < ./data/fifteen-minutes.ndjson > ./data/fifteen-minutes.geojson

gpkg:
	@ogr2ogr -f "GPKG" ./data/fifteen-minutes.gpkg ./data/fifteen-minutes.geojson
