# ThinkerCare Terrain · Guide du parcours simplifié

## Source et périmètre
Le cahier des charges est le texte de la gestionnaire transmis par le propriétaire le 14 novembre 2026 : planning hebdomadaire, pointage début/fin, stock pharmacie, ventes, rapports et réclamations accessibles aux médecins. Cette application est distincte de Touché Conseil B2C. Sa base, ses comptes et ses sessions ne sont pas partagés.

## Matrice des accès
| Rôle | Planning / stock / ventes | Rapports | Réclamations | Référentiels |
|---|---|---|---|---|
| Animatrice | Ses animations assignées et les derniers relevés des pharmacies où elle est affectée | Ses animations uniquement | Création, contenu de son propre signalement et retour opérationnel | Lecture catalogue |
| Gestionnaire | Toutes les animations, programmation, annulation avant début, corrections motivées | Pilotage et validation | Métadonnées, attribution médecin ; pas de texte de tolérance ni de note privée médicale sauf son propre signalement | Points de vente, appareils, produits |
| Direction | Même périmètre opérationnel | Tous les rapports | Métadonnées et actions administratives, sans note médicale privée | Comptes, produits, points de vente, appareils, traçabilité |
| Médecin | Aucun tableau commercial ni inventaire | Aucun rapport de ventes | Signalements, prise en charge, notes privées médecins et retour opérationnel partagé | Catalogue nécessaire au contexte |

L’administrateur valide l’identité et le rôle professionnel avant de créer les comptes. Un rôle n’est pas changé sur un compte existant : désactiver puis créer un compte distinct. Les permissions sont appliquées côté serveur, y compris pour les photos. Les pouvoirs techniques d’administration de l’hébergement restent distincts des permissions applicatives.

## Démarrage
1. Se connecter à `direction` avec le mot de passe initial transmis séparément. Le remplacer immédiatement.
2. Créer un compte nominatif pour la gestionnaire, chaque animatrice et chaque médecin.
3. Ajouter les pharmacies / cosmétiques / grossistes et adresses réelles.
4. Ajouter les identifiants des appareils Dermoscan.
5. Vérifier les 86 références importées des sites officiels le 14 novembre 2026 : 66 TOUCHÉ et 20 BELNCO, teintes et lots professionnels distincts. La vente affiche par défaut 53 références hors lots professionnels. Ajouter les références NOOM vérifiées si nécessaire. Les prix catalogue sont des repères modifiables, pas des prix de pharmacie certifiés.
6. Programmer une animation, puis la tester avec une animatrice assignée et des données non personnelles.

## Planning et pointage
- Semaine affichée du lundi au dimanche ; heure de référence Africa/Algiers.
- Une animatrice par animation, une ou plusieurs marques. Pour un travail en équipe, programmer une animation par personne sans doubler les ventes attribuées ; un modèle de mission collective n’est pas implémenté.
- Le lieu d’installation est obligatoire si un Dermoscan est sélectionné. Les collisions d’horaires de l’animatrice et de l’appareil sont bloquées en base, même avec deux gestionnaires simultanés.
- Début : le jour prévu, par l’animatrice assignée, avec une photo du lieu. Fin : après un début enregistré, avec une nouvelle photo. Photo et horaire sont enregistrés ensemble ; un envoi échoué ne valide pas le pointage. L’heure réelle est celle du serveur. La gestionnaire ne pointe pas à sa place.
- Tolérance de retard réglable par animation (0 à 120 minutes, 15 par défaut). La direction et la gestionnaire voient les arrivées non pointées et les arrivées tardives des huit derniers jours. L’alerte peut être marquée comme vue sans effacer le retard. Prévu 08:00, arrivée 12:00 : retard affiché de 4 h. Alertes dans l’application ouverte, sans SMS, WhatsApp, courriel ou notification système en arrière-plan.
- Statut de l’animation : programmée, en cours, terminée, annulée. Une animation déjà commencée n’est pas effacée par une annulation administrative : pointer la fin et préciser l’incident au rapport.
- Actualisation automatique toutes les 20 secondes quand l’écran est visible ; ce n’est pas une connexion instantanée par WebSocket. L’heure d’actualisation et les erreurs restent visibles.
- Internet nécessaire. Pas de pointage hors ligne ni de géolocalisation. Une photo aide au contrôle mais ne certifie pas la présence : selon le téléphone, le sélecteur peut proposer une image déjà enregistrée. Aucune reconnaissance faciale. L’API ne prend pas d’horodatage client arbitraire.

## Stocks
Le stock de départ se saisit une seule fois dans une liste commune. Un champ laissé vide reste inconnu : il ne bloque pas la vente et n’est jamais converti en zéro. Les ventes diminuent automatiquement le stock théorique connu. Les ventes supérieures à un stock renseigné sont rejetées. Le comptage final ne porte que sur les références dont le stock de départ est connu.

Pour chaque produit compté : stock vendable de départ, entrées, sorties hors ventes, stock final physique, produits abîmés observés, quantité proche de péremption et date la plus proche, observations.
`Stock final théorique = départ + entrées − sorties hors ventes − unités des tickets valides`.
Un écart avec le comptage final exige une explication avant soumission. Aucun écart n’est converti automatiquement en vente.
Les abîmés sont hors vendable ; ne pas les soustraire deux fois. Une casse pendant la mission est une sortie hors ventes motivée. Les dates proches sont signalées à 90 jours par convention initiale de suivi, et les dates dépassées distinguées. Ce n’est pas un seuil réglementaire.
La vue pharmacie affiche le dernier stock final compté par référence avec la date. Elle ne connaît pas les ventes de la pharmacie entre deux animations. Les produits non comptés ne sont pas présentés comme à zéro.

## Ventes et rapports
- Ticket = une vente comprenant plusieurs lignes. Chaque ligne contient une quantité et un prix réellement pratiqué.
- Catalogue visuel et recherche par nom, marque, teinte ; lots professionnels masqués par défaut. Ajouter les produits, ajuster les quantités et enregistrer. Le formulaire reste ouvert pour la vente suivante.
- Calcul côté serveur, montants en centimes de DZD. Le dernier prix saisi pour cette pharmacie est proposé, sinon le prix indicatif du catalogue ; il reste modifiable. Un prix absent doit être renseigné, jamais transformé en vente gratuite.
- Un pack compte comme une unité commerciale vendue ; le rapport ne transforme pas implicitement les composants en pièces.
- UUID de ticket pour retries, aucune insertion dupliquée. Les conflits de modifications sont rejetés et demandent une actualisation.
- Annuler une saisie erronée : responsable seulement, motif obligatoire, historique conservé ; pas de gestion des remboursements clients ou des encaissements.
- Pointage de fin distinct de la soumission du rapport : complétude des comptages, explication des écarts, affirmation explicite si aucune vente.
- Rapport brouillon → soumis → validé ou à corriger. Un rapport validé ne se modifie pas sans réouverture motivée par la gestionnaire.
- Rapports par date de l’animation, personne, pharmacie, marque et produit. Quantités / montants déclarés, jamais chiffres encaissés ni marge.

## Photos et réclamations
- Photos de produits/rayons/installations seulement. Pas de personnes, pièces d’identité, prescriptions ni résultats Dermoscan. Le client convertit l’image en JPEG redimensionné, sans métadonnées EXIF d’origine ; le serveur valide le format binaire, taille maximale 20 Mo, accès privé R2.
- Photos d’arrivée et de départ, plus jusqu’à 15 photos de suivi par animation. Aucun lien de bucket public. La suppression/rétention automatique n’est pas encore implémentée : prévoir une procédure administrateur avant utilisation à grande échelle.
- Réclamation : qualité, commercial ou tolérance ; produit, lot, code anonyme et faits. Accord explicite demandé pour la transmission anonymisée d’un signalement de tolérance.
- Les notes privées ne sont visibles qu’aux comptes médecins. Le retour opérationnel doit rester sans détail médical. Les médecins voient les dossiers du service, pas uniquement ceux déjà attribués.
- Aucun diagnostic automatique, score Dermoscan, messagerie patient ni système d’urgence. Ne pas utiliser ce formulaire à la place d’une prise en charge urgente.
- Avant de saisir des informations réelles, faire valider par votre responsable compétent le cadre de confidentialité, les habilitations, l’information des personnes, l’hébergement et la durée de conservation. Cette version ne revendique pas une conformité réglementaire certifiée.

## Architecture et exploitation
React / TanStack Start, un Worker Cloudflare, D1 pour les données, R2 privé pour les photos.
- `src/terrain/App.tsx` : interfaces par rôle.
- `src/terrain/QuickTools.tsx` : catalogue, vente rapide, stock groupé, pointage photo et alertes.
- `src/terrain/core.ts` : calculs et règles pures.
- `src/terrain/api.server.ts` : authentification, autorisations, validation et transactions.
- `src/routes/api/terrain.ts`, `photos.ts` : points d’entrée authentifiés.
- `migrations/0002_terrain.sql` : schéma et données d’initialisation ; `0004_terrain_workflow.sql` : catalogue et parcours simplifié, sans suppression de données opérationnelles.
- `tests/terrain.mjs`, `tests/schema.py` : règles et contraintes.
Aucun raccordement Shopify, caisse, ERP, transporteur ou Dermoscan n’est activé. Aucune commission issue de Touché Conseil n’est reprise.
Ne jamais exporter les sessions, mots de passe initiaux, sels/hachages des comptes avec un dossier public. Avant auto-hébergement, créer un export nettoyé, de nouvelles clés et un premier administrateur propre.

## Limites et recette
Référentiels : 2 000 produits/points de vente, 1 000 personnes/appareils ; animations : 2 000 dans une sélection ; rapports : 20 000 lignes ; réclamations : 1 000 dans une période ; audit : 300 derniers événements. Les dépassements de rapports et historiques sont signalés, les totaux incomplets ne sont pas présentés comme complets.
Tester avec deux animatrices, une gestionnaire et un médecin : création planning, collisions, pointages, relevé zéro et non zéro, ventes/prix, annulation de saisie, photo, compte rendu, corrections, visibilité des réclamations et sessions révoquées.
Les essais locaux de cette livraison utilisent uniquement des données fictives en mémoire et des écrans isolés. La recette authentifiée complète sur le site hébergé reste à effectuer, notamment l’upload R2 et l’accès des comptes via la passerelle de la plateforme.


## Réclamations, demandes et retours terrain — 14 novembre 2026
L’onglet Réclamations donne accès à trois espaces : Réclamations, Demandes et Retours terrain. Une création reste possible à tout moment, sans animation ni pharmacie obligatoire, depuis un appel ou après la fin et la validation d’une animation. Les raccourcis de la fiche animation préremplissent le contexte. Une pharmacie déjà référencée reste limitée aux affectations de l’animatrice ; un nouveau lieu peut être indiqué en texte libre sans donner accès à ses données.

Réclamations : emballage, aspect/texture, casse/fuite, péremption/lot, rupture, prix/promotion, livraison, service, tolérance et autre. Demandes : animation, Dermoscan, réassort, matériel/testeurs, formation, rappel/visite, partenariat et autre. Chaque dossier comprend un motif, un canal, un texte libre, un produit/lot facultatif, une priorité, une date souhaitée et un responsable. Le suivi conserve le statut, les réponses et les compléments. Les dates souhaitées ne créent pas automatiquement une animation : la gestionnaire programme le créneau après accord.

Les médecins voient les réclamations, pas les demandes commerciales ni le carnet terrain. Les détails et compléments de tolérance restent accessibles à l’auteur et aux médecins ; la direction gère l’attribution et le retour opérationnel sans le contenu médical. Le transfert vers le nouvel outil conserve les dossiers existants et leurs notes privées. L’ancienne table est conservée en archive, les anciennes écritures sont désactivées.

Retours terrain : rayon/mise en avant, concurrence, avis client (positif/neutre/négatif), disponibilité, opportunité et autre. Texte, marque/produit, concurrent et cinq photos maximum par observation. La direction indique Vu ou Action engagée et une réponse visible par l’animatrice. Aucun avis n’est publié sur un site externe. Photos privées, sans visages ni documents personnels. Une observation reste enregistrée même si une photo échoue ; seules les photos restantes sont réessayées.

## Primes et statistiques
Règle appliquée : 50 DA par ticket de vente valide, indépendant du nombre de produits. Le ticket porte 5 000 centimes de prime. La prime appartient à l’animatrice assignée à l’animation, y compris si une responsable saisit le ticket. Les ventes existantes reçoivent la même règle. Une vente annulée contribue zéro au CA, aux quantités et à la prime. Une correction d’animation validée suit toujours le circuit de réouverture.

Jour et mois sont calculés selon la date de l’animation, en heure d’Alger. L’animatrice voit ses montants du jour, du mois, la progression de la période et l’historique mensuel (13 derniers mois). Les responsables voient toute l’équipe et peuvent filtrer par période, personne et pharmacie. Les totaux globaux proviennent d’agrégations SQL, sans plafonnement des tickets pris en compte. Les tableaux dépassant 1 000 personnes ou 2 000 produits/pharmacies sont signalés et l’export est désactivé pour ne pas présenter un détail incomplet.

Le classement compare les ventes ou le CA ; les tableaux détaillent produits, unités, marques, pharmacies, panier moyen, primes, animations terminées et retards. Un ticket multimarque compte une seule fois dans les ventes et les primes ; les ventes concernées par produit/marque ne se cumulent pas entre lignes. Les primes sont des montants calculés : aucun paiement, bulletin de paie ni statut payé n’est simulé.

## Relevé de stock simplifié
Quantité directe ou boutons +, − et 0 ; filtre marque, recherche et filtre produits déjà renseignés. Le dernier relevé connu de la pharmacie peut être proposé dans les champs non renseignés, avec la date de chaque source. Ces valeurs ne sont jamais enregistrées sans confirmation de l’animatrice. Elles doivent être vérifiées physiquement. Un champ vide reste inconnu ; le bouton 0 signifie une rupture constatée.
