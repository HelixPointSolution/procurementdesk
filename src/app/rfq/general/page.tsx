import RfqEditor from "@/components/RfqEditor";

export default function RfqGeneralPage() {
  return (
    <div>
      <h2 className="text-xl font-bold mb-4">RFQ — General (non-material)</h2>
      <RfqEditor kind="general" />
    </div>
  );
}
