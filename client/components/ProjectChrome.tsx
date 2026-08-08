import { useEffect, useState } from "react";
import { api, type Project } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

/** Shared active-Project chrome (badge-only until a real picker lands). */
export function ProjectChrome() {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api.getProject().then(setProject).catch(console.error);
  }, []);

  if (!project) return null;

  return <Badge variant="secondary">{project.name}</Badge>;
}
