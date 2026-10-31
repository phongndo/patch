import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <section className="empty-state full-screen">
      <h1>Page not found</h1>
      <Link to="/">Back to home</Link>
    </section>
  ),
});

function RootLayout() {
  return <Outlet />;
}
