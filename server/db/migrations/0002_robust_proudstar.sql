CREATE TABLE `runs` (
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
	`cost` integer,
	`error` text,
	`log_path` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
