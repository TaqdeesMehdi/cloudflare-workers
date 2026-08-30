import { t } from "@/worker/trpc/trpc-instance";

import { z } from "zod";

import {
  getEvaluations,
  getNotAvailableEvaluation,
} from "@repo/data-ops/queries/evaluations";
export const evaluationsTrpcRoutes = t.router({
  problematicDestinations: t.procedure.query(async ({ ctx }) => {
    return await getNotAvailableEvaluation(ctx.userInfo.userId);
  }),

  recentEvaluations: t.procedure
    .input(
      z
        .object({
          createdBefore: z.string().optional(),
        })
        .optional(),
    )
    .query(async () => {
      const evaluations = await getEvaluations("testaccountId");

      const oldestCreatedAt =
        evaluations.length > 0
          ? evaluations[evaluations.length - 1].createdAt
          : null;

      return {
        data: evaluations,
        oldestCreatedAt,
      };
    }),
});
