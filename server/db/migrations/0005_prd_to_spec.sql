UPDATE `card_steps` SET `step_key` = 'spec' WHERE `step_key` = 'prd';--> statement-breakpoint
UPDATE `artifacts` SET `step_key` = 'spec' WHERE `step_key` = 'prd';--> statement-breakpoint
UPDATE `artifacts` SET `kind` = 'spec' WHERE `kind` = 'prd';--> statement-breakpoint
UPDATE `runs` SET `step_key` = 'spec' WHERE `step_key` = 'prd';
