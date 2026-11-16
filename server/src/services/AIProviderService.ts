import { AI_PROVIDER_PRESETS, type AIProviderPreset } from '../config/aiProviderPresets';

/**
 * T05784：厂商预制目录的只读出口。
 * 目录是后端单源，前端只消费 API；未来新增厂商只需扩充 config 文件，
 * 不需要改 AIToolsPage 或任何前端组件。
 */
export const AIProviderService = {
  list(): readonly AIProviderPreset[] {
    return AI_PROVIDER_PRESETS;
  },

  getById(id: string): AIProviderPreset | undefined {
    return AI_PROVIDER_PRESETS.find((p) => p.id === id);
  },
};
