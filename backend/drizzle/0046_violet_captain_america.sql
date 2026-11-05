CREATE TABLE "orbit_candidate_evidence" (
	"candidate_id" integer PRIMARY KEY NOT NULL,
	"resume_key" varchar(1000) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"extractor_version" integer NOT NULL,
	"pages" jsonb NOT NULL,
	"passages" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orbit_evidence_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"fact_id" varchar(64) NOT NULL,
	"state" varchar(24) NOT NULL,
	"reason" text NOT NULL,
	"decided_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orbit_job_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"source" varchar(16) DEFAULT 'recruiter' NOT NULL,
	"description_hash" varchar(64) NOT NULL,
	"requirements" jsonb NOT NULL,
	"created_by" integer NOT NULL,
	"approved_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	CONSTRAINT "uq_orbit_job_requirements_version" UNIQUE("job_id","version")
);
--> statement-breakpoint
ALTER TABLE "orbit_candidate_evidence" ADD CONSTRAINT "orbit_candidate_evidence_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_evidence_overrides" ADD CONSTRAINT "orbit_evidence_overrides_candidate_id_orbit_candidate_evidence_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."orbit_candidate_evidence"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_evidence_overrides" ADD CONSTRAINT "orbit_evidence_overrides_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_job_requirements" ADD CONSTRAINT "orbit_job_requirements_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_job_requirements" ADD CONSTRAINT "orbit_job_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_job_requirements" ADD CONSTRAINT "orbit_job_requirements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orbit_overrides_candidate_fact" ON "orbit_evidence_overrides" USING btree ("candidate_id","fact_id");--> statement-breakpoint
CREATE INDEX "idx_orbit_job_requirements_job" ON "orbit_job_requirements" USING btree ("job_id");