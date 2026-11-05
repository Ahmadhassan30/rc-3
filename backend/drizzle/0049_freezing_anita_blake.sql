CREATE TABLE "orbit_candidate_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"resume_key" varchar(1000) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"requirements_version" integer NOT NULL,
	"scoring_version" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"overall_score" integer,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_or_uncertain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_error" text,
	"embedding_model" varchar(200),
	"embedding_version" varchar(32),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_orbit_assessment_generation" UNIQUE("candidate_id","job_id","resume_key","requirements_version","scoring_version")
);
--> statement-breakpoint
ALTER TABLE "orbit_candidate_assessments" ADD CONSTRAINT "orbit_candidate_assessments_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_candidate_assessments" ADD CONSTRAINT "orbit_candidate_assessments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orbit_assessments_job_score" ON "orbit_candidate_assessments" USING btree ("job_id","overall_score");