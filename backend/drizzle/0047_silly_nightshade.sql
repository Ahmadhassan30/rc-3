CREATE TABLE "orbit_passage_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"resume_key" varchar(1000) NOT NULL,
	"passage_id" varchar(64) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"extractor_version" integer NOT NULL,
	"page_index" integer NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"section" varchar(32) NOT NULL,
	"text" text NOT NULL,
	"embedding_model" varchar(200) NOT NULL,
	"embedding_version" varchar(32) NOT NULL,
	"dimensions" integer NOT NULL,
	"vector" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_orbit_passage_embedding_version" UNIQUE("candidate_id","passage_id","embedding_version")
);
--> statement-breakpoint
ALTER TABLE "orbit_passage_embeddings" ADD CONSTRAINT "orbit_passage_embeddings_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_orbit_passage_embeddings_candidate" ON "orbit_passage_embeddings" USING btree ("candidate_id");