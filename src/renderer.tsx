import { jsxRenderer } from 'hono/jsx-renderer'

declare module 'hono' {
  interface ContextRenderer {
    (content: string | Promise<string> | any, props?: { title?: string }): Response
  }
}

export const renderer = jsxRenderer(({ children, title }) => {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ? `${title} | SalonMotion` : 'SalonMotion'}</title>
        <link href="/static/logo-icon.png" rel="icon" type="image/png" />
        <link href="/static/logo-icon.png" rel="apple-touch-icon" />
        <link href="/static/tailwind.css" rel="stylesheet" />
        <link href="/static/fontawesome/css/all.min.css" rel="stylesheet" />
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body class="bg-gray-50 min-h-screen text-gray-800">{children}</body>
    </html>
  )
})
