CREATE TABLE `card_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`step_key` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_steps_card_id_step_key_unique` ON `card_steps` (`card_id`,`step_key`);--> statement-breakpoint
INSERT INTO `card_steps` (`id`, `card_id`, `step_key`, `status`)
SELECT lower(hex(randomblob(8))), `id`, 'info', 'needs-user'
FROM `cards`
WHERE `id` NOT IN (SELECT `card_id` FROM `card_steps` WHERE `step_key` = 'info');