-- 009_site_content_images.sql
-- Ajoute 3 entrées modifiables dans `site_content` pour piloter, depuis le
-- panneau admin → onglet "Contenu", l'image affichée sur :
--   • la page d'accueil (Hero)
--   • la page de connexion
--   • la page d'inscription
--
-- Si la valeur est vide, le frontend retombe sur l'image groupée par défaut.

INSERT INTO site_content (section, key, label, value, type)
VALUES
  ('hero',         'hero_community_image',   'Image communauté (page d''accueil)', '', 'image'),
  ('auth_login',   'auth_login_image',       'Image page de connexion',            '', 'image'),
  ('auth_signup',  'auth_signup_image',      'Image page d''inscription',          '', 'image')
ON CONFLICT (key) DO NOTHING;
