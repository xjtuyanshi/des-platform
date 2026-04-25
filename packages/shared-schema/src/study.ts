import { z } from 'zod';

import { AiNativeDesModelDefinitionSchema } from './model-dsl.js';

export const StudyOperationDefinitionSchema = z.object({
  experimentId: z.string(),
  outputName: z.string().optional(),
  htmlReport: z.boolean().default(true)
});

export const SimulationStudyCaseDefinitionSchema = z.object({
  schemaVersion: z.literal('des-platform.study.v1'),
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  modelPath: z.string().optional(),
  model: AiNativeDesModelDefinitionSchema.optional(),
  outputDir: z.string().optional(),
  validate: z.boolean().default(true),
  failOnValidationError: z.boolean().default(true),
  runs: z.array(StudyOperationDefinitionSchema).default([]),
  replications: z.array(StudyOperationDefinitionSchema).default([]),
  sweeps: z.array(StudyOperationDefinitionSchema).default([]),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
}).superRefine((study, context) => {
  if (study.runs.length === 0 && study.replications.length === 0 && study.sweeps.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runs'],
      message: 'Study must define at least one run, replication, or sweep operation'
    });
  }

  if (!study.modelPath && !study.model) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelPath'],
      message: 'Study must define either modelPath or an inline model'
    });
  }

  if (study.modelPath && study.model) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'Study must define modelPath or inline model, not both'
    });
  }
});

export type StudyOperationDefinition = z.infer<typeof StudyOperationDefinitionSchema>;
export type SimulationStudyCaseDefinition = z.infer<typeof SimulationStudyCaseDefinitionSchema>;
