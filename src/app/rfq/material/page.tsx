import RfqEditor from "@/components/RfqEditor";

export default function RfqMaterialPage() {
  return (
    <div>
      <h2 className="text-xl font-bold mb-4">RFQ — Material</h2>
      <RfqEditor kind="material" />
    </div>
  );
}
