// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "FunScript",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/de-angelov/funscript",
        },
      ],
      sidebar: [
        {
          label: "Guides",
          items: [
            { label: "Overview", slug: "guides/overview" },
            { label: "Language Overview", slug: "guides/language-overview" },
            { label: "Syntax", slug: "guides/syntax" },
            { label: "Tooling", slug: "guides/tooling" },
            { label: "Compatibility", slug: "guides/compatibility" },
          ],
        },
        {
          label: "Reference",
          items: [
            {
              label: "Language Contracts",
              slug: "reference/language-contracts",
            },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Docs Audit Plan", slug: "project/docs-audit-plan" },
            { label: "Roadmap", slug: "project/roadmap" },
          ],
        },
      ],
    }),
  ],
});
