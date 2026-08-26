/**
 * Site configuration.
 *
 * This file is yours — upstream ships defaults and never overwrites it.
 * Content lives in the brain directories; this only controls presentation.
 */
export default {
  /** Shown in the header and the browser title bar. */
  title: 'My Knowledge Base',

  /** One-line description, used in the meta description tag and on the home page. */
  description: 'An AI-assisted knowledge base built with Almagest.',

  /** Optional link to YOUR repo, shown in the header. Set to null to hide. */
  repoUrl: null as string | null,

  /**
   * Optional link to the Almagest framework, used in the footer attribution.
   * Left null so the footer never ships a dead link. Set it once the framework
   * repo is public, e.g. 'https://github.com/you/almagest'.
   */
  frameworkUrl: 'https://github.com/oleharland/Almagest' as string | null,

  /** Group the index by this frontmatter field. 'type' or 'tier'. */
  groupBy: 'type' as 'type' | 'tier',

  /** Show pages whose slug starts with '_' (the shipped example page). */
  showExamplePages: true,
};
