-- Restore the editable website-content rows after the Supabase-to-MySQL
-- migration. INSERT IGNORE keeps every value already customized by an admin.
INSERT IGNORE INTO site_content (section, `key`, label, `value`, type)
VALUES
  ('hero', 'hero_community_image', 'Image communauté (page d''accueil)', '', 'image'),
  ('services', 'services_title', 'Titre de la section Services', 'Services par plateforme', 'text'),
  ('footer', 'footer_tagline', 'Texte de présentation du pied de page', 'La plateforme leader de croissance sur les réseaux sociaux en Afrique francophone.', 'text'),
  ('footer', 'footer_logo_image', 'Logo du pied de page', '', 'image'),
  ('auth_login', 'auth_login_image', 'Image page de connexion', '', 'image'),
  ('auth_signup', 'auth_signup_image', 'Image page d''inscription', '', 'image');