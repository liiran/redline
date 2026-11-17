FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/redline .

FROM scratch
COPY --from=build /out/redline /redline
# Runs as "nobody": the program needs no privileges and writes no files.
USER 65534:65534
ENTRYPOINT ["/redline"]
