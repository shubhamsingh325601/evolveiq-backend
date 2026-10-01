-- EvolvIQ — Platform Admin school management (create / list / view / rename).
--
-- updated_at records the last rename. Existing rows get now() as their initial value;
-- Prisma's @updatedAt keeps it current on every update made through the client.
ALTER TABLE "schools" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- Serve ORDER BY name / created_at with LIMIT/OFFSET for the paginated list endpoint.
CREATE INDEX "schools_name_idx" ON "schools"("name");
CREATE INDEX "schools_created_at_idx" ON "schools"("created_at");
