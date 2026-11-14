# ThinkerCare Terrain — dossier de reprise développeur

Version source : `0af38fb1353dc5daa0d43d221b305edd57e5afaa`.
Export des données : **14 novembre 2026 à 16:05:08 UTC**.

Ce dossier conserve la dernière application Higgsfield, y compris les modules récents de réclamations indépendantes, primes et observations terrain. Il ne correspond pas à la démonstration limitée publiée séparément.

**État : dernière version source, données applicatives et tous les médias référencés récupérés et vérifiés ; déploiement complet non validé.**

Les deux photos privées qui manquaient dans la première sauvegarde sont maintenant incluses en fichiers originaux, après connexion au compte Direction. Les tailles correspondent exactement aux métadonnées : 122 542 et 115 693 octets.
Il ne faut pas présenter ce dossier comme un logiciel qui ne demande plus qu'un clic pour être mis en production. La configuration propre à l'hébergeur cible, la revue du code et la recette de l'application restent à réaliser.

## Ce qui est présent

| Dossier | Contenu vérifié |
| --- | --- |
| `01_application_source/` | Les 578 fichiers suivis de la dernière version, sous leur arborescence originale. Application dans `app/`. |
| `02_historique/` | Historique Git au format bundle. |
| `03_donnees/` | Même instantané en JSON, SQLite et SQL ; schéma d'origine. 16 tables applicatives, 137 lignes. |
| `04_medias_catalogue/` | 51 images originales ; correspondances avec les URL du catalogue et empreintes SHA-256. |
| `05_medias_prives/` | Les deux photos privées originales, leurs clés de stockage, leur inventaire et leurs empreintes SHA-256. |
| `06_audit/` | Contrôles d'intégrité, version source, inventaire des fichiers et statut réel de publication. |
| `07_documentation/` | Instructions de reprise, réponse du support, limites et recette attendue. |

Le catalogue exporté contient **86 références : 66 TOUCHÉ et 20 BELNCO**, y compris les références de lots. Aucune référence NOOM ne se trouve dans la base exportée. Les huit visuels locaux de l'application sont dans `01_application_source/app/public/`.

Les 18 références fictives signalées dans le manifeste des médias proviennent des tests ou exemples du code. Ce ne sont pas des images de catalogue oubliées : toutes les URL d'image non vides du catalogue réel sont couvertes par les 51 fichiers récupérés.

## Points non terminés

- L'inventaire exhaustif du stockage privé, notamment d'éventuels objets sans référence en base, n'est pas attesté.
- Les données de la table interne Cloudflare `_cf_KV` ne sont pas exportées. Son schéma est conservé, mais cette table n'est volontairement pas créée vide dans la reconstruction SQLite : cela éviterait de donner une fausse impression de récupération complète.
- La configuration de production et les accès internes de l'hébergement Higgsfield ne sont pas portables avec le code. Aucun secret applicatif configuré n'a été déclaré par le service.
- Le contrôle de publication de la dernière version reste bloqué ; voir le diagnostic exact dans `06_audit/statut-publication.json` et la réponse du support. Aucun contrôle n'a été désactivé ou contourné.

## Contrôles réalisés

Les 578 fichiers source ont été comparés par SHA-256 avec le dépôt propriétaire actuel : correspondance exacte. L'instantané des 16 tables applicatives, des migrations appliquées et des séquences a été lu en une seule requête. La copie SQLite passe les contrôles d'intégrité et de relations. Les données relues correspondent exactement au JSON. Le fichier SQL reconstruit une base valide avec les mêmes effectifs. Chaque image de catalogue a été vérifiée par taille et empreinte.

Pour contrôler les fichiers après téléchargement, ouvrir un terminal dans ce dossier et lancer :

```sh
python3 verifier_dossier.py
```

Ce contrôle fonctionne sans réseau et ne modifie pas l'application. Un succès certifie l'intégrité des fichiers remis, pas leur capacité à fonctionner en production.

**Confidentialité :** le dossier contient des données internes, des empreintes de mots de passe et des métadonnées de sessions. Le remettre uniquement au développeur concerné, par un canal privé.
