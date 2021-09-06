compute:
	@./index.js -i flevoland-overijssel-drenthe.geojson \
		> ./data/fifteen-minutes.ndjson

# geojson:
# 	@../ndjson-to-geojson/ndjson-to-geojson.js < ./data/walkability.ndjson > ./data/walkability.geojson

# gpkg:
# 	@ogr2ogr -f "GPKG" ./data/walkability.gpkg ./data/walkability.geojson
