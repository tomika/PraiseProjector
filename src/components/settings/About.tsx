import React from "react";

const About: React.FC = () => {
  const version = "1.0.0"; // This could be read from package.json
  const buildDate = new Date().toLocaleDateString();

  return (
    <div>
      <h5>PraiseProjector</h5>
      <p>Version: {version} (Electron)</p>
      <p>Build Date: {buildDate}</p>
      <p>Cross-platform praise presentation software.</p>
      <p>For more information, visit the project&apos;s website.</p>
      <p>&copy; 2024-{new Date().getFullYear()}</p>
    </div>
  );
};

export default About;
