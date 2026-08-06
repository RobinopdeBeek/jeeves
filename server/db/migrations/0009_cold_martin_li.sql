CREATE TABLE `card_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`path` text NOT NULL,
	`instruction` text DEFAULT '' NOT NULL,
	`origin_step` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
