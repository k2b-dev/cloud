import type { ComponentProps } from "solid-js";
import FormSubmit from "./PublicFormSubmit";

export default function FormSubmitIsland(props: ComponentProps<typeof FormSubmit>) {
  return <FormSubmit {...props} />;
}
