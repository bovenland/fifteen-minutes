dir = /Volumes/ExFat/Boven.land/data/fifteen-minutes

hexgrid:
	@./hexgrid.js > ${dir}/hexgrid.ndjson

origins:
	@./origins.js < .${dir}/hexgrid.ndjson \
		> ${dir}/origins.ndjson

reachability:
	@./compute-reachability.js < ${dir}/origins.ndjson \
		> ${dir}/reachability.ndjson

routes:
	@./compute-routes.js < ${dir}/reachability.ndjson \
		> ${dir}/routes.ndjson

pois:
	@./pois.js \
		> ${dir}/pois.ndjson

analyze:
	@./analyze-routes.js < ${dir}/routes.ndjson \
		> ${dir}/analyzed.ndjson

sqlite:
	@rm -f ${dir}/analyzed.db
	@cat ${dir}/analyzed.ndjson \
		| sqlite-utils insert ${dir}/analyzed.db analyzed - --nl --truncate --ignore --pk=osmId

# geojson:
# 	@cat ${dir}/analyzed.ndjson \
# 		| jq -c '{ \
# 			osmId: .osmId, postcode: .postcode, geometry: .origin, \
# 			circumference: .area.circumference, areaCircumferenceRatio: .area.areaCircumferenceRatio, \
# 			area: .area.area, \
# 			maxDistancePerSegment0: .routes.maxDistancePerSegment[0], \
# 			maxDistancePerSegment1: .routes.maxDistancePerSegment[1], \
# 			maxDistancePerSegment2: .routes.maxDistancePerSegment[2], \
# 			maxDistancePerSegment3: .routes.maxDistancePerSegment[3], \
# 			maxDistancePerSegment4: .routes.maxDistancePerSegment[4], \
# 			maxDistancePerSegment5: .routes.maxDistancePerSegment[5], \
# 			maxDistancePerSegment6: .routes.maxDistancePerSegment[6], \
# 			maxDistancePerSegment7: .routes.maxDistancePerSegment[7], \
# 		} + .routes.stats' \
# 		| ../ndjson-to-geojson/ndjson-to-geojson.js \
# 		> ${dir}/analyzed.geojson

geojson:
	@cat ${dir}/analyzed.ndjson \
		| jq -c '{ \
			postcode: .postcode, \
			osmId: .osmId, geometry: .origin, \
			area: .area.area, \
		}' \
		| ../ndjson-to-geojson/ndjson-to-geojson.js \
		> ${dir}/analyzed.geojson

mbtiles:
	@tippecanoe \
  	--no-tile-size-limit \
		--no-feature-limit \
		-Z7 -z13 \
    -b0 -r1 \
    -o ${dir}/analyzed.mbtiles -f \
		--extend-zooms-if-still-dropping ${dir}/analyzed.geojson

extract:
	@mkdir ${dir}/tiles
	@mb-util --image_format=pbf ${dir}/analyzed.mbtiles ${dir}/tiles/analyzed

s3-tiles:
	@aws s3 sync ${dir}/tiles/analyzed s3://files.boven.land/tiles/vijftien-minuten-verderop --content-encoding gzip

s3-routes:
	@cat ${dir}/analyzed.ndjson \
		| ./prepare-for-web.js \
		| jq -c '{ \
				Bucket: "files.boven.land", \
				Key: ("data/vijftien-minuten-verderop/routes/" + .osmId + ".json"), \
				Body: . \
			}' \
		| ../ndjson-to-s3/index.js
