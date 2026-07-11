import { t } from "@/worker/trpc/trpc-instance";

import { z } from "zod";
import { EVALUATION_ISSUES, EVALUATIONS } from "./dummy-data";

export const evaluationsTrpcRoutes = t.router({
  problematicDestinations: t.procedure.query(async ({}) => {
    return EVALUATION_ISSUES;
  }),
  recentEvaluations: t.procedure
    .input(
      z
        .object({
          createdBefore: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({}) => {
      const evaluations = EVALUATIONS;

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
