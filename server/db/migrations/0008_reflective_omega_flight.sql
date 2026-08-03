CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
