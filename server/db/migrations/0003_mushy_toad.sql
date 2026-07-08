PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`step_key` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`skill` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost` real,
	`error` text,
	`log_path` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "card_id", "step_key", "round", "skill", "status", "started_at", "finished_at", "model", "tokens_in", "tokens_out", "cost", "error", "log_path") SELECT "id", "card_id", "step_key", "round", "skill", "status", "started_at", "finished_at", "model", "tokens_in", "tokens_out", "cost", "error", "log_path" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;