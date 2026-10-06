import { z } from "zod";
import { IssueIdOrRefSchema } from "./common";

export const MAX_RESOLUTION_WINDOW_SECONDS = 366 * 86400;

// REST supplies query strings; MCP supplies numbers. Avoid broad coercion, which
// would silently turn null, false, and an empty string into epoch zero.
const EpochSecondsSchema = z
	.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
	.pipe(z.number().int().nonnegative());

const CursorSchema = z
	.string()
	.max(160)
	.regex(/^(0|[1-9]\d*):[1-9]\d*$/, "Invalid resolution event cursor")
	.refine((value) => value.split(":").every((part) => Number.isSafeInteger(Number(part))), {
		message: "Invalid resolution event cursor timestamp or sequence",
	});

export const ListIssueResolutionEventsSchema = z
	.object({
		after: EpochSecondsSchema,
		before: EpochSecondsSchema,
		projectId: z.string().min(1).optional(),
		issueId: IssueIdOrRefSchema.optional(),
		cursor: CursorSchema.optional(),
		limit: EpochSecondsSchema.pipe(z.number().min(1).max(200)).default(100),
	})
	.superRefine((data, ctx) => {
		if (data.before <= data.after) {
			ctx.addIssue({
				code: "custom",
				path: ["before"],
				message: "before must be greater than after",
			});
		} else if (data.before - data.after > MAX_RESOLUTION_WINDOW_SECONDS) {
			ctx.addIssue({
				code: "custom",
				path: ["before"],
				message: "Resolution event window must not exceed 366 days",
			});
		}
	});
