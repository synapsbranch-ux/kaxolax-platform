# syntax=docker/dockerfile:1.7
#
# Image du job de sauvegarde PostgreSQL (service cron Railway) et du test de restauration :
# clients PostgreSQL 18, rclone et age, épinglés par empreinte. Contexte = racine du monorepo :
#   docker build -f scripts/backup/Dockerfile -t kaxolax-pg-backup .
# CMD : sauvegarde. Test de restauration : /opt/kaxolax/backup/pg-restore-test.sh

# pg_dump doit être d'une version au moins égale à celle du serveur (PostgreSQL 18 sur Railway).
FROM postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873

# Binaires officiels (pas de paquet apk : versions et empreintes fixes). Pas de nom RCLONE_* :
# rclone lit ces variables comme des options.
ARG RCLONE_RELEASE=1.75.1
ARG AGE_RELEASE=1.3.2
ADD --checksum=sha256:982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab \
  https://github.com/rclone/rclone/releases/download/v${RCLONE_RELEASE}/rclone-v${RCLONE_RELEASE}-linux-amd64.zip /tmp/rclone.zip
ADD --checksum=sha256:cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 \
  https://github.com/FiloSottile/age/releases/download/v${AGE_RELEASE}/age-v${AGE_RELEASE}-linux-amd64.tar.gz /tmp/age.tar.gz
RUN unzip -q -j /tmp/rclone.zip "rclone-v${RCLONE_RELEASE}-linux-amd64/rclone" -d /usr/local/bin \
  && tar -xzf /tmp/age.tar.gz -C /usr/local/bin --strip-components=1 age/age age/age-keygen \
  && rm /tmp/rclone.zip /tmp/age.tar.gz \
  && chmod 0755 /usr/local/bin/rclone /usr/local/bin/age /usr/local/bin/age-keygen \
  && rclone version \
  && age --version

COPY --chmod=0555 scripts/backup/lib.sh scripts/backup/pg-backup.sh scripts/backup/pg-restore-test.sh \
  /opt/kaxolax/backup/

# Utilisateur non privilégié de l'image (postgres, UID 70) ; aucun serveur PostgreSQL ne tourne.
USER postgres
WORKDIR /tmp
ENTRYPOINT []
CMD ["/opt/kaxolax/backup/pg-backup.sh"]
