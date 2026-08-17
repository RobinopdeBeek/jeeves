UPDATE `card_steps` SET `step_key` = 'implement' WHERE `step_key` = 'impl';--> statement-breakpoint
UPDATE `card_steps` SET `step_key` = 'ai-review' WHERE `step_key` = 'airev';--> statement-breakpoint
UPDATE `card_steps` SET `step_key` = 'prepare-human-review' WHERE `step_key` = 'prepeval';--> statement-breakpoint
UPDATE `card_steps` SET `step_key` = 'human-review' WHERE `step_key` = 'review';--> statement-breakpoint
UPDATE `runs` SET `step_key` = 'implement' WHERE `step_key` = 'impl';--> statement-breakpoint
UPDATE `runs` SET `step_key` = 'ai-review' WHERE `step_key` = 'airev';--> statement-breakpoint
UPDATE `runs` SET `step_key` = 'prepare-human-review' WHERE `step_key` = 'prepeval';--> statement-breakpoint
UPDATE `runs` SET `step_key` = 'human-review' WHERE `step_key` = 'review';--> statement-breakpoint
UPDATE `artifacts` SET `step_key` = 'implement' WHERE `step_key` = 'impl';--> statement-breakpoint
UPDATE `artifacts` SET `step_key` = 'ai-review' WHERE `step_key` = 'airev';--> statement-breakpoint
UPDATE `artifacts` SET `step_key` = 'prepare-human-review' WHERE `step_key` = 'prepeval';--> statement-breakpoint
UPDATE `artifacts` SET `step_key` = 'human-review' WHERE `step_key` = 'review';--> statement-breakpoint
UPDATE `artifacts` SET `kind` = 'human-review-report' WHERE `kind` = 'eval';--> statement-breakpoint
UPDATE `card_attachments` SET `origin_step` = 'implement' WHERE `origin_step` = 'impl';--> statement-breakpoint
UPDATE `card_attachments` SET `origin_step` = 'ai-review' WHERE `origin_step` = 'airev';--> statement-breakpoint
UPDATE `card_attachments` SET `origin_step` = 'prepare-human-review' WHERE `origin_step` = 'prepeval';--> statement-breakpoint
UPDATE `card_attachments` SET `origin_step` = 'human-review' WHERE `origin_step` = 'review';
