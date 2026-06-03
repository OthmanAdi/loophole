import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * Define the `docs` content collection explicitly with Starlight's loader and
 * schema. Astro 5 uses the content layer; without this file Starlight
 * auto-generates the collection and warns. Declaring it here is the documented
 * pattern, clears the deprecation warning, and makes slug resolution
 * deterministic for the sidebar config.
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
