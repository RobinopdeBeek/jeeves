CREATE TABLE `card_blockers` (
	`card_id` text NOT NULL,
	`blocks_on_card_id` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocks_on_card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_blockers_card_id_blocks_on_card_id_unique` ON `card_blockers` (`card_id`,`blocks_on_card_id`);--> statement-breakpoint
ALTER TABLE `cards` ADD `parent_card_id` text REFERENCES cards(id);--> statement-breakpoint
ALTER TABLE `cards` ADD `branch` text;