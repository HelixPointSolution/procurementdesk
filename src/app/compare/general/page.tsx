import CompareEditor from "@/components/CompareEditor";

export default function CompareGeneralPage() {
  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Quote Comparison — General</h2>
      <CompareEditor kind="general" />
    </div>
  );
}
