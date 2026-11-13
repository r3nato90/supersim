import { createFileRoute } from "@tanstack/react-router";

// /inicio/up1/ (sem index.html) -> /inicio/up1/index.html, mantendo UTMs
async function handleGet({ request, params }: { request: Request; params: { folder: string } }) {
  const url = new URL(request.url);
  const folder = params.folder;
  if (!/^up([1-9]|1[0-2])$/.test(folder)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/inicio/${folder}/index.html${url.search}`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export const Route = createFileRoute("/inicio/$folder")({
  server: { handlers: { GET: handleGet } },
  component: () => null,
});
