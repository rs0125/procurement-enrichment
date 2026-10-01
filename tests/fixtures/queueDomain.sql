CREATE EXTENSION IF NOT EXISTS postgis;
DROP TABLE IF EXISTS labeled_warehouse_images,"CronRunLog",warehouse_proximity,osm_ingest_tile,osm_poi,osm_highway CASCADE;
DROP TYPE IF EXISTS "ImageClass","DocumentKind" CASCADE;
CREATE TYPE "ImageClass" AS ENUM ('INDOOR','OUTDOOR','DOCUMENT','UNKNOWN');
CREATE TYPE "DocumentKind" AS ENUM ('LAYOUT','PAPERWORK','OTHER_DOCUMENT','NOT_A_DOCUMENT');
CREATE TABLE labeled_warehouse_images (
 id serial PRIMARY KEY,"warehouseId" int,"imageUrl" text UNIQUE,classification "ImageClass",description text,confidence float8,model text,"labelledAt" timestamptz,
 "documentKind" "DocumentKind","unreferencedAt" timestamptz,
 "storageBucket" text,"originalObjectKey" text,"webpUrl" text,"webpObjectKey" text,"webpBytes" bigint,"webpAt" timestamptz,"webpCheckedAt" timestamptz,"webpVersion" text,
 "jpegUrl" text,"jpegBytes" bigint,"jpegAt" timestamptz,"jpegVersion" text,"jpegStatus" text DEFAULT 'PENDING',"jpegError" text,
 "websiteOverride" jsonb,"websiteDecision" text,"websiteQualityTier" text,"websiteAssessment" jsonb,"websiteAssessedAt" timestamptz
);
DO $$ DECLARE stage text; BEGIN
 FOREACH stage IN ARRAY ARRAY['label','document','website','webp'] LOOP
  EXECUTE format('ALTER TABLE labeled_warehouse_images ADD COLUMN %I text DEFAULT ''PENDING'',ADD COLUMN %I int DEFAULT 0,ADD COLUMN %I timestamptz,ADD COLUMN %I timestamptz,ADD COLUMN %I text,ADD COLUMN %I text',
   stage||'Status',stage||'Attempts',stage||'LeaseUntil',stage||'NextAttemptAt',stage||'ClaimToken',stage||'Error');
 END LOOP;
END $$;
ALTER TABLE "WarehouseData" ADD COLUMN geog geography(Point,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography) STORED;
ALTER TABLE "GeocodeAttempt" ADD COLUMN "lastVia" text,ADD COLUMN "lastError" text;
CREATE TABLE "CronRunLog" (id bigserial PRIMARY KEY,"jobName" text NOT NULL,"ranAt" timestamp DEFAULT now(),status text NOT NULL,"durationMs" int NOT NULL,metadata jsonb,notes text);
CREATE INDEX ON "CronRunLog" ("jobName","ranAt");
CREATE TABLE warehouse_proximity (id serial PRIMARY KEY,"warehouseId" int,category text,status text DEFAULT 'OK',"landmarkName" text,"poiSource" text,"poiId" text,"poiLat" float8,"poiLng" float8,"roadKm" float8,"driveMinutes" int,provider text,profile text,candidates int,warnings text[] DEFAULT '{}',attempts int DEFAULT 1,"lastError" text,"computedAt" timestamptz DEFAULT now(),"computedFromLat" float8,"computedFromLng" float8,"poiWatermark" timestamptz,UNIQUE("warehouseId",category));
CREATE TABLE osm_ingest_tile (id serial PRIMARY KEY,category text,status text);
CREATE TABLE osm_poi (id serial PRIMARY KEY,category text,"importedAt" timestamptz);
CREATE TABLE osm_highway (id serial PRIMARY KEY,"importedAt" timestamptz);
