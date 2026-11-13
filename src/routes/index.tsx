import { createFileRoute } from "@tanstack/react-router";

async function handleGet({ request }: { request: Request }) {
  const search = new URL(request.url).search;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/inicio/1.html${search}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export const Route = createFileRoute("/")({
  server: { handlers: { GET: handleGet } },
  component: () => null,
});
