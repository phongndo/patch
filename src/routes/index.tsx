import { createFileRoute } from "@tanstack/react-router";
import { Reviewer } from "../review/Reviewer";

export const Route = createFileRoute("/")({ component: Reviewer });
