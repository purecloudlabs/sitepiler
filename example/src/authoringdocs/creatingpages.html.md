---
title: Creating Pages
---

## Frontmatter Properties

Frontmatter must begin as the first line in the file and must use exactly three dashes to mark the beginning and end of the frontmatter block. Properties must be specified in the format of `name: value`, one per line. Example:

```
---
title: A page title
layout: layoutname
customproperty: true
---
```

All properties specified in the frontmatter object will be available as part of the page's data. The page being rendered is available via `context.page`. For example, to access the page's title, use `context.page.title`.


### Standard Properties

| Property | Description |
|---|---|
| title | the page's title |
| layout | the name of the layout to use when rendering the page. Defaults to `default` if not specified. |
| order | Override for order in siblings list. Value of 1 will be a the top of the list, bigger numbers lower. If not set, will appear sorted alphabetically below all prioritized pages. |
| renderMarkdown | If `false`, skips rendering using markdown and only executes the template. Use for non-HTML files, like a JSON file. |

### Suggested Properties

These properties aren't used by sitepiler directly, but are some suggested options that authors may wish to make use of in their templates.

| Property | Description |
|---|---|
| notoc | `true` to exclude from navigation |
| ispreview | `true` to include a preview banner at the top of the site |
| hideTitle | `true` to hide the page's title from the layout |


## Special Behavior

### Implied titles

In the absense of a title in the frontmatter setting, if the first line in a page is a markdown heading, the text of the heading will be used as the page's title. The attribute `hideTitle` will also be set to `true`. The actual body of the page will remain unaffected. 
