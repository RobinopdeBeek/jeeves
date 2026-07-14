CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`step_key` text NOT NULL,
	`round` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`git_sha` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
