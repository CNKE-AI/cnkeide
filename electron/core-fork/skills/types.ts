export type SkillKind = 'prompt' | 'package';
export type SkillSource = 'builtin' | 'bundled' | 'local';

export interface PromptSkillDefinition {
  id: string;
  name: string;
  description: string;
  kind: 'prompt';
  source: 'builtin';
  systemPrompt: string;
}

export interface PackageSkillDefinition {
  id: string;
  name: string;
  description: string;
  kind: 'package';
  source: SkillSource;
  version?: string;
  rootPath: string;
  entryPath: string;
  available: boolean;
  error?: string;
}

export type SkillDefinition = PromptSkillDefinition | PackageSkillDefinition;

export interface SkillView extends Omit<SkillDefinition, 'systemPrompt'> {
  enabled: boolean;
}
