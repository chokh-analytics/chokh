import { z } from 'zod';

// The owner's word on a share, and a reader's password.

export const putShareSchema = z
  .object({
    regenerate: z.boolean().optional(),
    // A password to set, null to take it off, absent to leave it as it is.
    // Eight characters like an account's: a share behind "1234" is a share.
    password: z.string().min(8, 'A password is at least 8 characters').max(200).nullable().optional(),
  })
  .strict();

export type PutShareInput = z.infer<typeof putShareSchema>;

export const unlockShareSchema = z
  .object({
    password: z.string().min(1, 'The password is empty').max(200),
  })
  .strict();

export const shareParamsSchema = z.object({
  token: z.string().min(1).max(64),
});
